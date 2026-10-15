import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactTokenSchema } from '../src/artifacts-token.js';
test('provider tokens are opaque but bounded, header safe and explicitly expiring',()=>{
  for(const value of ['art_v1_'+'a'.repeat(40),'different_provider_prefix:opaque-value=='])
    assert.ok(artifactTokenSchema.safeParse(value+'?expires=1791780000').success);
  for(const value of ['opaque token?expires=1791780000','opaque\r\ninjected?expires=1791780000','opaque?expires=1791780000&extra=1','opaque?expires=invalid','opaque?other=1?expires=1791780000','a'.repeat(1024)+'?expires=1791780000','opaque'])
    assert.equal(artifactTokenSchema.safeParse(value).success,false);
});
