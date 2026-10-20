import { expect,it } from 'vitest';
import { moduleImports } from '../helpers/moduleImports.js';
it('distinguishes UI import URLs from actual static, exported and dynamic dependencies',()=>{
 expect(moduleImports(`const ui={action:'/s/materials/answers/import',children:'text'}; import x from 'express'; export {a} from './a.js'; const p=import('new-dependency'); import 'side-effect';`)).toEqual(['express','./a.js','new-dependency','side-effect']);
});
