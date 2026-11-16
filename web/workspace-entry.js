const button=document.querySelector('#open'),status=document.querySelector('#status');
button.addEventListener('click',async()=>{button.disabled=true;try{const result=await fetch('/api/workspace',{method:'POST'});if(!result.ok)throw Error('无法联系 Coo');status.textContent='已请求打开 Coo 角色工作台。';}catch(error){status.textContent=String(error);}finally{button.disabled=false;}});
