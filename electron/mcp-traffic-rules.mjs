import { z } from 'zod';

// Map Remote, Rewrite and Block rules share the revisioned /api/traffic-tools configuration with Map Local.
const id = z.string().min(1).max(256);
const common = { id, name: z.string().min(1).max(256), enabled: z.boolean(), pattern: z.string().min(1).max(4096), method: z.string().min(1).max(64),
  group: z.string().max(64).optional() };
const headerOps = z.array(z.object({ op: z.enum(['set', 'remove']), name: z.string().min(1).max(256), value: z.string().max(8192).optional() })).max(50);
const path = z.string().max(2048);

// Appended to tools that wait for the user to click Allow in Streamglass (see confirm in mcp-tools.mjs).
export const APPROVAL = 'Needs the user\'s approval: Streamglass shows an Allow/Deny dialog and this call waits until they answer, up to 2 minutes. Tell the user to approve it in the Streamglass window before or while calling; a denied or unanswered request returns an error and must not be retried without asking them.';
const REDIRECT_APPROVAL = `Enabling a redirect to a server the user has not approved before ${APPROVAL.charAt(0).toLowerCase()}${APPROVAL.slice(1)}`;

export const trafficRuleTypes = {
  mapRemoteRules: { label: 'Map Remote', tool: 'map_remote', shape: { ...common, scheme: z.enum(['http', 'https']), host: z.string().min(1).max(253),
    port: z.number().int().min(0).max(65535), pathFrom: path, pathTo: path, keepHost: z.boolean(), headerOps },
  description: 'Redirect matching requests to another scheme/host/port, optionally rewriting a path prefix and preserving the rest of the path and query. headerOps set or remove headers (for example Authorization, Cookie, X-Session-Id) on redirected requests only, so staging and production credentials stay separate. port 0 means the scheme default; keepHost keeps the original Host header.' },
  rewriteRules: { label: 'Rewrite', tool: 'rewrite', shape: { ...common, phase: z.enum(['request', 'response']), headerOps, statusCode: z.number().int().min(0).max(599),
    bodyFind: z.string().max(4096), bodyReplace: z.string().max(65536) },
  description: 'Modify request headers, or response headers/status code and literal (not regex) UTF-8 text in complete bodies of at most 8 MiB. Streamed, SSE, binary and larger bodies are forwarded unchanged. Request rules support headers only; statusCode 0 keeps the status.' },
  blockRules: { label: 'Block', tool: 'block', shape: { ...common, action: z.enum(['respond', 'close']), statusCode: z.number().int().min(400).max(599), body: z.string().max(4096) },
  description: 'Answer matching requests with a synthetic 4xx/5xx response (action respond) or close the connection (action close) without contacting the origin.' },
};

export function registerTrafficRuleTools({ tool, serializeMutation, updateTrafficTools, api, page, textPage, offset, limit, maxChars }) {
  const read = async key => { const { config, revision } = await api('/api/traffic-tools'); return { revision, rules: config[key] ?? [] }; };
  for (const [key, type] of Object.entries(trafficRuleTypes)) {
    const { label, tool: name, shape, description } = type;
    const list = (value, k = key) => (value[k] ??= []);
    tool(`list_${name}_rules`, `List ${label} rules in matching order (paginated summaries; headerOps and bodies counted, use get_${name}_rule for full detail).`, { offset, limit, group: z.string().max(64).optional() }, true, async a => {
      const { revision, rules } = await read(key);
      const filtered = rules.filter(rule => a.group === undefined || (rule.group ?? '') === a.group);
      const summary = filtered.map(({ headerOps: ops = [], bodyFind = '', bodyReplace = '', body = '', ...rule }) => ({ ...rule, headerOpsCount: ops.length, ...(bodyFind || bodyReplace ? { bodyFindChars: bodyFind.length, bodyReplaceChars: bodyReplace.length } : {}), ...(body ? { bodyChars: body.length } : {}) }));
      const result = page(summary, a.offset, a.limit);
      return { revision, rules: result.items, offset: result.offset, total: result.total, nextOffset: result.nextOffset };
    });
    tool(`get_${name}_rule`, `Read one ${label} rule as paginated JSON text.`, { ruleId: id, offset, maxChars }, true, async a => {
      const { revision, rules } = await read(key);
      const rule = rules.find(r => r.id === a.ruleId);
      if (!rule) throw new Error(`${label} rule not found`);
      return { revision, ...textPage(JSON.stringify(rule), a.offset, a.maxChars) };
    });
    tool(`upsert_${name}_rule`, `Create or replace a ${label} rule. ${description} Rules apply top to bottom and only while capture is not paused. HTTP validators are authoritative.${key === 'mapRemoteRules' ? ` ${REDIRECT_APPROVAL}` : ''}`, { rule: z.object(shape) }, false, a => serializeMutation(async () => {
      const revision = await updateTrafficTools(value => {
        const rules = list(value), index = rules.findIndex(r => r.id === a.rule.id);
        if (index < 0) rules.push(a.rule); else rules[index] = a.rule;
        return value;
      });
      return { saved: true, id: a.rule.id, revision };
    }), true);
    tool(`set_${name}_rule_enabled`, `Enable or disable one ${label} rule.${key === 'mapRemoteRules' ? ` ${REDIRECT_APPROVAL}` : ''}`, { ruleId: id, enabled: z.boolean() }, false, a => serializeMutation(async () => {
      const revision = await updateTrafficTools(value => {
        const rule = list(value).find(r => r.id === a.ruleId);
        if (!rule) throw new Error(`${label} rule not found`);
        rule.enabled = a.enabled;
        return value;
      });
      return { saved: true, id: a.ruleId, enabled: a.enabled, revision };
    }), true);
    tool(`delete_${name}_rule`, `Delete one ${label} rule.`, { ruleId: id }, false, a => serializeMutation(async () => {
      const revision = await updateTrafficTools(value => {
        if (!list(value).some(r => r.id === a.ruleId)) throw new Error(`${label} rule not found`);
        value[key] = value[key].filter(r => r.id !== a.ruleId);
        return value;
      });
      return { deleted: a.ruleId, revision };
    }), true);
    tool(`reorder_${name}_rules`, `Set ${label} matching order using every existing rule ID exactly once.`, { ruleIds: z.array(id).max(100) }, false, a => serializeMutation(async () => {
      const revision = await updateTrafficTools(value => {
        const byId = new Map(list(value).map(r => [r.id, r]));
        if (a.ruleIds.length !== byId.size || new Set(a.ruleIds).size !== byId.size || a.ruleIds.some(rid => !byId.has(rid))) throw new Error(`Provide every ${label} rule ID exactly once`);
        return { ...value, [key]: a.ruleIds.map(rid => byId.get(rid)) };
      });
      return { saved: true, revision };
    }), true);
  }
  tool('set_traffic_rule_group_enabled', `Enable or disable every Map Remote, Rewrite and Block rule whose group label matches (an environment profile such as "Staging"). Use an empty group for unlabelled rules. Map Local rules are not affected. ${REDIRECT_APPROVAL}`, {
    group: z.string().max(64), enabled: z.boolean(), types: z.array(z.enum(['map-remote', 'rewrite', 'block'])).min(1).max(3).default(['map-remote', 'rewrite', 'block']),
  }, false, a => serializeMutation(async () => {
    let changed = 0;
    const revision = await updateTrafficTools(value => {
      for (const [key, { tool: name }] of Object.entries(trafficRuleTypes)) {
        if (!a.types.includes(name.replace('_', '-'))) continue;
        for (const rule of value[key] ?? []) if ((rule.group ?? '') === a.group && rule.enabled !== a.enabled) { rule.enabled = a.enabled; changed++; }
      }
      return value;
    });
    return { saved: true, group: a.group, enabled: a.enabled, changed, revision };
  }), true);
}
