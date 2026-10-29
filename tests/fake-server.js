'use strict';
const readline=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{userAgent:'test'}});else if(m.method==='echo')send({id:m.id,result:m.params});else if(m.method==='fail')send({id:m.id,error:{code:-1,message:'expected error'}});else if(m.method==='trigger'){send({id:44,method:'item/tool/call',params:{tool:'remote_list',arguments:{path:'.'}}});send({id:m.id,result:{ok:true}});}else if(m.method==='exit')process.exit(3);});
