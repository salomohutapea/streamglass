import test from 'node:test';
import assert from 'node:assert/strict';
import {validateToolsInput,validateToolsAction} from '../electron/tools-window.mjs';

const view={filter:'search',scope:'url',mode:'contains',protocols:['HTTPS'],statuses:[2],device:'all',application:null,library:'all'};
test('Tools context only accepts bounded navigation and source-filter metadata',()=>{
  assert.deepEqual(validateToolsInput({section:'Map Local',recordId:'capture-1',view}),{section:'Map Local',recordId:'capture-1',view});
  assert.deepEqual(validateToolsInput({view,focus:false}),{view,focus:false});
  const fieldDraft={nonce:'5f0c2a43-8c55-4f7e-9d0b-1f6f4a6a2b11',pattern:'https://api.example.test/v2/search*',method:'POST',recordId:'capture-1'};
  assert.deepEqual(validateToolsInput({section:'Custom Fields',fieldDraft}),{section:'Custom Fields',fieldDraft});
  for(const invalid of [{fieldDraft:{...fieldDraft,nonce:'x'}},{fieldDraft:{...fieldDraft,pattern:''}},{fieldDraft:{...fieldDraft,recordId:'../x'}},{fieldDraft:{...fieldDraft,extra:1}},{section:'Watches'}])assert.throws(()=>validateToolsInput(invalid));
  for(const invalid of [{section:'unknown'},{recordId:'../capture'},{token:'secret'},{view:{...view,filter:'x'.repeat(1025)}},{view:{...view,statuses:[6]}},{focus:'yes'}])assert.throws(()=>validateToolsInput(invalid));
});
test('Tools actions only select captures or apply complete saved views',()=>{
  assert.deepEqual(validateToolsAction({action:'select-capture',recordId:'one'}),{action:'select-capture',recordId:'one'});
  const saved={...view,id:'saved',name:'Saved view'};
  assert.deepEqual(validateToolsAction({action:'apply-view',view:saved}),{action:'apply-view',view:saved});
  for(const value of [{action:'open-file',path:'/tmp/file'},{action:'select-capture',recordId:'../file'},{action:'apply-view',view}])assert.throws(()=>validateToolsAction(value));
});
