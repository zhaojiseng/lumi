import DefaultInterface from './renderer/Shell';
import {defaultInterfaceManifest} from './manifest';
import type {InterfacePlugin} from '../../src/host/interface';
export const defaultInterfacePlugin:InterfacePlugin={manifest:defaultInterfaceManifest,component:DefaultInterface};
