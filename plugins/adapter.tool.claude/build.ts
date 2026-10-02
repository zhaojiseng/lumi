import type {ConfigRequest} from '../../shared/types';
export function buildClaude(content: string | null, req: ConfigRequest, baseUrl: string, key: string) {
  const doc: any = content?.trim() ? JSON.parse(content) : {};
  doc.env = { ...doc.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: req.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: req.sonnet || req.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: req.opus || req.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: req.haiku || req.model,
  };
  delete doc.env.ANTHROPIC_AUTH_TOKEN;
  doc.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS=String(req.contextWindow ?? 256000);
  if(req.disableAttributionHeader!==false)doc.env.CLAUDE_CODE_ATTRIBUTION_HEADER='false';
  else delete doc.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  doc.model = req.model;
  return JSON.stringify(doc, null, 2) + '\n';
}
