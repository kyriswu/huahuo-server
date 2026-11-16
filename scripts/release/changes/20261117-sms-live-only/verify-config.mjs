const env=process.env;
const fail=()=>{throw new Error('SMS_RELEASE_CONFIGURATION_INVALID');};
const roles=['api-server','admin','worker','scheduler','migrate'];
if(!roles.includes(env.SERVICE_ROLE))fail();
if(env.SMS_PROVIDER!==undefined||env.SHOW_TEST_OTP!==undefined)fail();
if(env.SERVICE_ROLE==='api-server'){
  if(!env.ALIYUN_RAM_ACCESS_KEY_ID?.trim()||!env.ALIYUN_RAM_ACCESS_KEY_SECRET?.trim())fail();
  if(env.SMS_ALIYUN_SIGN_NAME!=='触达科技'||env.SMS_ALIYUN_TEMPLATE_CODE!=='SMS_508520316'||env.SMS_ALIYUN_CODE_PARAM!=='code')fail();
  if(env.SMS_ALIYUN_REGION_ID!=='cn-hangzhou'||env.SMS_ALIYUN_CONNECT_TIMEOUT_MS!=='3000'||env.SMS_ALIYUN_READ_TIMEOUT_MS!=='3000')fail();
}else if(env.SMS_ALIYUN_SIGN_NAME||env.SMS_ALIYUN_TEMPLATE_CODE)fail();
