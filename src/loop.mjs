export function clampSteps(value){const n=Number(value??3); if(!Number.isInteger(n)||n<1||n>3) throw new Error('--max-steps must be 1, 2, or 3'); return n;}
export async function boundedLoop({provider,prompt,model,maxSteps=3,onStep=()=>{}}){
  const limit=clampSteps(maxSteps); let output='';
  for(let step=1;step<=limit;step++){
    onStep(step,limit);
    const task=step===1?`${prompt}\n\nReturn a complete answer. End with ULTRON_DONE only when acceptance criteria are met.`:`Original goal:\n${prompt}\n\nPrevious result:\n${output}\n\nPerform a concise verification pass. Fix only material failures. Return the improved final answer and end with ULTRON_DONE when acceptable.`;
    output=await provider.ask(task,{model});
    if(/ULTRON_DONE\s*$/i.test(output.trim())) return {output:output.replace(/\n?ULTRON_DONE\s*$/i,'').trim(),steps:step,converged:true};
  }
  return {output,steps:limit,converged:false};
}
