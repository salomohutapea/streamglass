import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesListSearch,matchesRuleSearch} from './list-search.mjs';

const rule={id:'example',name:'Flight inventory',pattern:'https://api.example.test/search*',method:'POST',stages:['response','event'],enabled:false,folderId:'flight',script:'return response; // currency USD'};

test('list search treats words literally and requires every word across searchable fields',()=>{
  assert.equal(matchesListSearch('  MAP   LOCAL ',['Map Local','Traffic']),true);
  assert.equal(matchesListSearch('map regex.*',['Map Local']),false);
  assert.equal(matchesListSearch('network slow',['Network Conditioner','throttle slow bandwidth']),true);
  assert.equal(matchesListSearch('  ',[]),true);
});

test('rule searches cover URL, method, name, stage, folder, enabled state and script content',()=>{
  for(const query of ['flight post','example.test/search*','sse response','disabled','currency usd','payments']) {
    assert.equal(matchesRuleSearch(rule,query,[{id:'flight',name:'Payments'}]),true,query);
  }
  assert.equal(matchesRuleSearch(rule,'post unrelated'),false);
  assert.equal(matchesRuleSearch({...rule,method:'*'},'any'),true);
  assert.equal(matchesRuleSearch(rule,'sse request'),false);
  assert.equal(matchesRuleSearch(rule,'[invalid regex'),false);
});
