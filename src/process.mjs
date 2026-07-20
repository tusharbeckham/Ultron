import { spawn } from 'node:child_process';
export function runCommand(command,args,{cwd=process.cwd(),env=process.env,timeoutMs=600000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});
    let out='',err='';
    const timer=setTimeout(()=>{child.kill('SIGTERM'); reject(new Error(`Command timed out after ${timeoutMs}ms`));},timeoutMs);
    child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d);
    child.on('error',e=>{clearTimeout(timer);reject(e)});
    child.on('close',code=>{clearTimeout(timer); code===0?resolve({stdout:out.trim(),stderr:err.trim()}):reject(new Error(err.trim()||`${command} exited ${code}`));});
  });
}
export async function commandExists(command){
  const checker=process.platform==='win32'?'where':'which';
  try{await runCommand(checker,[command],{timeoutMs:3000});return true}catch{return false}
}
