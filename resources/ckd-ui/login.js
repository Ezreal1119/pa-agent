const prefix=location.pathname.startsWith('/admin')?'/admin':'';
const form=document.getElementById('login-form');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const button=form.querySelector('button');
  const error=document.getElementById('login-error');
  button.disabled=true;error.hidden=true;
  try{
    const response=await fetch(prefix+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CKD-UI':'1'},body:JSON.stringify({account:form.elements.account.value,password:form.elements.password.value})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'登录失败，请重试。');
    form.elements.password.value='';location.assign(prefix+'/');
  }catch(cause){error.textContent=cause.message;error.hidden=false;form.elements.password.value='';button.disabled=false;}
});
