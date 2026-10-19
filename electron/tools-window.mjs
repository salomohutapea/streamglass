import {z} from 'zod';

export const toolSections = ['Map Local','Network Conditioner','Sessions','Journeys','Watches','Assertions','Repeat','Views & notes','Compare','Replay','Scenarios','Create mock','Share','Workspaces','Codecs'];
const view = z.object({filter:z.string().max(1024),scope:z.enum(['url','request','response','event']),mode:z.enum(['contains','not_contains','equals','starts_with','ends_with','wildcard']),
  conditions:z.array(z.object({joiner:z.enum(['and','or']),scope:z.enum(['url','request','response','event']),mode:z.enum(['contains','not_contains','equals','starts_with','ends_with','wildcard']),filter:z.string().max(1024)}).strict()).max(7).optional(),protocols:z.array(z.enum(['HTTP','HTTPS','SSE'])).max(3),statuses:z.array(z.number().int().min(1).max(5)).max(5),device:z.string().min(1).max(256),application:z.string().max(1024).nullable(),library:z.enum(['all','sse','pinned'])}).strict();
const input = z.object({section:z.enum(toolSections).optional(),recordId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).nullable().optional(),view:view.optional(),focus:z.boolean().optional()}).strict();
export const validateToolsInput = value => input.parse(value);

export function validateToolsAction(value){
  return z.discriminatedUnion('action',[
    z.object({action:z.literal('select-capture'),recordId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)}).strict(),
    z.object({action:z.literal('apply-view'),view:view.extend({id:z.string().min(1).max(128),name:z.string().min(1).max(100)})}).strict(),
  ]).parse(value);
}
