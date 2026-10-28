import {z} from 'zod';

export const toolSections = ['Map Local','Map Remote','Rewrite','Block','Network Conditioner','Sessions','Journeys','Custom Fields','Assertions','Repeat','Saved filters','Notes','Compare','Replay','Scenarios','Create mock','Share','Workspaces','Codecs','Agent (MCP)'];
const view = z.object({filter:z.string().max(1024),scope:z.enum(['url','request','response','event']),mode:z.enum(['contains','not_contains','equals','starts_with','ends_with','wildcard']),
  conditions:z.array(z.object({joiner:z.enum(['and','or']),scope:z.enum(['url','request','response','event']),mode:z.enum(['contains','not_contains','equals','starts_with','ends_with','wildcard']),filter:z.string().max(1024)}).strict()).max(7).optional(),protocols:z.array(z.enum(['HTTP','HTTPS','SSE'])).max(3),statuses:z.array(z.number().int().min(1).max(5)).max(5),device:z.string().min(1).max(256),application:z.string().max(1024).nullable(),library:z.enum(['all','sse','pinned'])}).strict();
const recordId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
// A one-shot request to start a custom field for one API; the Tools window adds it unsaved once per nonce.
const fieldDraft = z.object({nonce:z.string().uuid(),pattern:z.string().min(1).max(4096),method:z.string().min(1).max(64),recordId:recordId.nullable().optional()}).strict();
const input = z.object({section:z.enum(toolSections).optional(),recordId:recordId.nullable().optional(),view:view.optional(),fieldDraft:fieldDraft.optional(),focus:z.boolean().optional()}).strict();
export const validateToolsInput = value => input.parse(value);

export function validateToolsAction(value){
  return z.discriminatedUnion('action',[
    z.object({action:z.literal('select-capture'),recordId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)}).strict(),
    z.object({action:z.literal('apply-view'),view:view.extend({id:z.string().min(1).max(128),name:z.string().min(1).max(100)})}).strict(),
  ]).parse(value);
}
