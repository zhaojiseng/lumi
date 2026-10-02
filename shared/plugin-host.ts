import type {
  BuiltinCapabilityMap, PluginCapabilityId, PluginCapabilityReference, PluginContext,
  PluginDisposer, PluginManifest, PluginState, PluginStatus, TrustedBuiltinPlugin,
} from './contracts/plugins';
import {BUILTIN_CAPABILITY_IDS} from './contracts/plugins';

export class PluginInactiveError extends Error {
  constructor(readonly sourceId: string) {
    super(`Plugin ${sourceId} is no longer active`);
    this.name = 'PluginInactiveError';
  }
}

/** Revoke retained methods and their eventual results with their owner's lifetime. */
function guardCapability<Value>(value:Value,assertCurrent:()=>void):Value {
  const wrappers=new Map<PropertyKey,{original:Function;wrapped:Function}>();
  // A separate target permits frozen objects and preserves class method receivers.
  return new Proxy({}, {
    get:(_target,key)=>{
      assertCurrent();
      const member:unknown=Reflect.get(value as object,key,value);
      if(typeof member!=='function')return member;
      const existing=wrappers.get(key);
      if(existing?.original===member)return existing.wrapped;
      const wrapped=(...args:unknown[])=>{
        assertCurrent();
        const result:unknown=Reflect.apply(member,value,args);
        if(result!==null && (typeof result==='object' || typeof result==='function') && typeof Reflect.get(result,'then')==='function'){
          return Promise.resolve(result).then(
            result=>{assertCurrent();return result;},
            error=>{assertCurrent();throw error;},
          );
        }
        assertCurrent();return result;
      };
      wrappers.set(key,{original:member,wrapped});return wrapped;
    },
  }) as Value;
}

export interface PluginHostOptions<Capabilities extends object = BuiltinCapabilityMap> {
  plugins: readonly TrustedBuiltinPlugin<Capabilities>[];
  /** Explicit allowlist for hosts with a different static capability contract. */
  capabilityIds?: readonly PluginCapabilityId<Capabilities>[];
}

interface Entry<Capabilities extends object> {
  plugin: TrustedBuiltinPlugin<Capabilities>;
  manifest: PluginManifest<PluginCapabilityId<Capabilities>>;
  state: PluginState;
  generation: number;
  error?: string;
  capabilities: Map<PluginCapabilityId<Capabilities>, unknown>;
  disposers: PluginDisposer[];
}

/** A static registry for trusted code, not a third-party plugin security boundary. */
export class PluginHost<Capabilities extends object = BuiltinCapabilityMap> {
  private readonly entries = new Map<string, Entry<Capabilities>>();
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private disposeResult?: Promise<void>;

  constructor(options: PluginHostOptions<Capabilities>) {
    const allowed = new Set<string>(options.capabilityIds ?? BUILTIN_CAPABILITY_IDS);
    for (const plugin of options.plugins) {
      const input = plugin.manifest;
      if (!input || typeof input.id !== 'string' || !input.id.trim() || typeof input.version !== 'string' || !input.version.trim()) {
        throw new Error('Plugin manifest requires a nonempty id and version');
      }
      if (input.hostApiVersion !== 1) throw new Error(`Unsupported host API version for ${input.id}`);
      if (typeof input.configurable !== 'boolean') throw new Error(`Missing configurable flag for ${input.id}`);
      if (input.defaultEnabled!==undefined && typeof input.defaultEnabled!=='boolean') throw new Error(`Invalid default enabled flag for ${input.id}`);
      if (typeof plugin.activate !== 'function') throw new Error(`Missing activate function for ${input.id}`);
      if(input.settings){
        const settings=input.settings,ids=new Set<string>();
        if(!settings.title?.trim() || !Number.isFinite(settings.order) || !Array.isArray(settings.views))throw new Error(`Invalid settings declaration for ${input.id}`);
        for(const view of settings.views){
          if(!/^[a-z][a-z0-9.-]{0,79}$/.test(view.id) || !view.title?.trim() || ids.has(view.id) || (view.defaultEnabled!==undefined && typeof view.defaultEnabled!=='boolean'))throw new Error(`Invalid settings view for ${input.id}: ${view.id}`);
          ids.add(view.id);
        }
      }
      if (this.entries.has(input.id)) throw new Error(`Duplicate plugin id: ${input.id}`);
      if (!Array.isArray(input.requires) || !Array.isArray(input.optional) || !Array.isArray(input.provides)) {
        throw new Error(`Invalid capability declarations for ${input.id}`);
      }
      const provided = new Set<string>();
      for (const capability of input.provides) {
        if (!allowed.has(capability)) throw new Error(`Unsupported capability: ${capability}`);
        if (provided.has(capability)) throw new Error(`Duplicate scoped capability: ${input.id}/${capability}`);
        provided.add(capability);
      }
      const references = new Set<string>();
      for (const ref of [...input.requires, ...input.optional]) {
        if (!ref || typeof ref.sourceId !== 'string' || !ref.sourceId.trim() || !allowed.has(ref.capability)) {
          throw new Error(`Invalid dependency for ${input.id}`);
        }
        const key = JSON.stringify([ref.sourceId, ref.capability]);
        if (references.has(key)) throw new Error(`Duplicate dependency for ${input.id}: ${ref.sourceId}/${ref.capability}`);
        references.add(key);
      }
      // Snapshot declarations so caller mutation cannot change the validated graph.
      const freezeRefs = (refs: readonly PluginCapabilityReference<PluginCapabilityId<Capabilities>>[]) =>
        Object.freeze(refs.map(ref => Object.freeze({ sourceId: ref.sourceId, capability: ref.capability })));
      const manifest = Object.freeze({
        id: input.id, version: input.version, hostApiVersion: 1 as const, configurable: input.configurable,
        ...(input.defaultEnabled!==undefined ? {defaultEnabled:input.defaultEnabled} : {}),
        requires: freezeRefs(input.requires), optional: freezeRefs(input.optional), provides: Object.freeze([...input.provides]),
        ...(input.settings ? {settings:Object.freeze({...input.settings,views:Object.freeze(input.settings.views.map(view=>Object.freeze({...view})))})} : {}),
      });
      this.entries.set(manifest.id, { plugin, manifest, state: 'disabled', generation: 0, capabilities: new Map(), disposers: [] });
    }
    for (const entry of this.entries.values()) {
      for (const ref of entry.manifest.requires) {
        if (!this.entries.get(ref.sourceId)?.manifest.provides.includes(ref.capability)) {
          throw new Error(`Missing required capability for ${entry.manifest.id}: ${ref.sourceId}/${ref.capability}`);
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (entry: Entry<Capabilities>) => {
      const id = entry.manifest.id;
      if (visiting.has(id)) throw new Error(`Plugin dependency cycle: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const ref of [...entry.manifest.requires, ...entry.manifest.optional]) {
        const provider = this.entries.get(ref.sourceId);
        if (provider?.manifest.provides.includes(ref.capability)) visit(provider);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const entry of this.entries.values()) visit(entry);
  }

  getStatuses(): PluginStatus<PluginCapabilityId<Capabilities>>[] {
    return [...this.entries.values()].map(({ manifest, state, error }) => ({ manifest, state, ...(error ? { error } : {}) }));
  }

  isEnabled(id: string): boolean { return this.entry(id).state === 'active'; }

  listProviders<Id extends PluginCapabilityId<Capabilities>>(capability: Id): string[] {
    return [...this.entries.values()].filter(entry => entry.state === 'active' && entry.capabilities.has(capability)).map(entry => entry.manifest.id);
  }

  getCapability<Id extends PluginCapabilityId<Capabilities>>(sourceId: string, capability: Id): Capabilities[Id] | undefined {
    if(this.closing)return undefined;
    const entry = this.entries.get(sourceId);
    return entry?.state === 'active' ? entry.capabilities.get(capability) as Capabilities[Id] | undefined : undefined;
  }

  requireCapability<Id extends PluginCapabilityId<Capabilities>>(sourceId: string, capability: Id): Capabilities[Id] {
    const value = this.getCapability(sourceId, capability);
    if (value === undefined) throw new Error(`Capability is not active: ${sourceId}/${capability}`);
    return value;
  }

  enable(id: string): Promise<void> {
    return this.enqueue(async () => {
      const activated: Entry<Capabilities>[] = [];
      const activate = async (entry: Entry<Capabilities>) => {
        if (entry.state === 'active') return;
        for (const ref of entry.manifest.requires) await activate(this.entry(ref.sourceId));
        await this.activate(entry);
        activated.push(entry);
      };
      try { await activate(this.entry(id)); }
      catch (error) {
        const failures: unknown[] = [error];
        for (const entry of activated.reverse()) {
          try { await this.deactivate(entry); } catch (cleanupError) { failures.push(cleanupError); }
        }
        if (failures.length > 1) throw new AggregateError(failures, `Plugin activation and rollback failed: ${id}`);
        throw error;
      }
    });
  }

  /** Required consumers are stopped first; optional consumers remain active. */
  disable(id: string): Promise<void> {
    return this.enqueue(async () => {
      const target = this.entry(id);
      const failures: unknown[] = [];
      const stopped = new Set<string>();
      const stop = async (entry: Entry<Capabilities>) => {
        if (stopped.has(entry.manifest.id)) return;
        stopped.add(entry.manifest.id);
        for (const consumer of this.entries.values()) {
          if (consumer.state === 'active' && consumer.manifest.requires.some(ref => ref.sourceId === entry.manifest.id)) await stop(consumer);
        }
        try { await this.deactivate(entry); } catch (error) { failures.push(error); }
      };
      await stop(target);
      if (failures.length) throw new AggregateError(failures, `Plugin cleanup failed: ${id}`);
    });
  }

  /** Reject new operations immediately, finish queued operations, then stop all. */
  dispose(): Promise<void> {
    if (this.disposeResult) return this.disposeResult;
    this.closing = true;
    this.disposeResult = this.enqueue(async () => {
      const failures: unknown[] = [];
      // Reverse activation order is recorded by insertion into this set.
      for (const entry of [...this.activationOrder].reverse()) {
        try { await this.deactivate(entry); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Plugin host cleanup failed');
    }, true);
    return this.disposeResult;
  }

  private readonly activationOrder = new Set<Entry<Capabilities>>();

  private entry(id: string): Entry<Capabilities> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown plugin: ${id}`);
    return entry;
  }

  private enqueue(operation: () => Promise<void>, duringDispose = false): Promise<void> {
    if (this.closing && !duringDispose) return Promise.reject(new Error('Plugin host is disposed'));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private async activate(entry: Entry<Capabilities>): Promise<void> {
    entry.state = 'activating';
    entry.error = undefined;
    const generation = ++entry.generation;
    const assertCurrent = () => {
      if (entry.generation !== generation || (entry.state !== 'activating' && entry.state !== 'active')) {
        throw new PluginInactiveError(entry.manifest.id);
      }
    };
    const assertDeclared = (sourceId: string, capability: PluginCapabilityId<Capabilities>) => {
      assertCurrent();
      if (![...entry.manifest.requires, ...entry.manifest.optional].some(ref => ref.sourceId === sourceId && ref.capability === capability)) {
        throw new Error(`Undeclared dependency for ${entry.manifest.id}: ${sourceId}/${capability}`);
      }
    };
    const assertCapabilityCurrent=()=>{
      assertCurrent();
      if(this.closing)throw new PluginInactiveError(entry.manifest.id);
    };
    const context: PluginContext<Capabilities> = {
      manifest: entry.manifest,
      provide: (capability, value) => {
        assertCurrent();
        if (entry.state !== 'activating') throw new Error(`Capability registration is closed: ${entry.manifest.id}`);
        if (!entry.manifest.provides.includes(capability)) throw new Error(`Undeclared capability: ${entry.manifest.id}/${capability}`);
        if (entry.capabilities.has(capability)) throw new Error(`Duplicate scoped capability: ${entry.manifest.id}/${capability}`);
        if (typeof value !== 'object' || value === null) throw new Error(`Capability must be an object: ${entry.manifest.id}/${capability}`);
        const guarded=guardCapability(value,assertCapabilityCurrent);
        entry.capabilities.set(capability, guarded);
      },
      onDispose: disposer => {
        assertCurrent();
        if (typeof disposer !== 'function') throw new Error('Plugin disposer must be a function');
        entry.disposers.push(disposer);
      },
      getCapability: (sourceId, capability) => {
        assertDeclared(sourceId, capability);
        const value=this.getCapability(sourceId,capability);
        return value===undefined ? undefined : guardCapability(value,assertCapabilityCurrent);
      },
      requireCapability: (sourceId, capability) => {
        assertDeclared(sourceId, capability);
        return guardCapability(this.requireCapability(sourceId,capability),assertCapabilityCurrent);
      },
    };
    try {
      const disposer = await entry.plugin.activate(context);
      if (disposer !== undefined) context.onDispose(disposer);
      for (const capability of entry.manifest.provides) {
        if (!entry.capabilities.has(capability)) throw new Error(`Plugin did not provide declared capability: ${entry.manifest.id}/${capability}`);
      }
      entry.state = 'active';
      this.activationOrder.add(entry);
    } catch (error) {
      const failures: unknown[] = [error];
      try { await this.deactivate(entry); } catch (cleanupError) { failures.push(cleanupError); }
      entry.state = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      if (failures.length > 1) throw new AggregateError(failures, `Plugin activation cleanup failed: ${entry.manifest.id}`);
      throw error;
    }
  }

  private async deactivate(entry: Entry<Capabilities>): Promise<void> {
    if (entry.state === 'disabled') return;
    entry.state = 'deactivating';
    ++entry.generation; // Invalidate retained references and in-flight results before cleanup.
    entry.capabilities.clear();
    this.activationOrder.delete(entry);
    const failures: unknown[] = [];
    const disposers = entry.disposers.splice(0).reverse();
    for (const disposer of disposers) {
      try { await disposer(); } catch (error) { failures.push(error); }
    }
    entry.state = 'disabled';
    entry.error = undefined;
    if (failures.length) throw new AggregateError(failures, `Plugin cleanup failed: ${entry.manifest.id}`);
  }
}

export function createPluginHost<Capabilities extends object = BuiltinCapabilityMap>(options: PluginHostOptions<Capabilities>): PluginHost<Capabilities> {
  return new PluginHost(options);
}
