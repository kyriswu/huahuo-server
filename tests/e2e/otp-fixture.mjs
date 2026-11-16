import { randomInt, randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';

// Only the HTTP test client imports this fixture. The application has no simulated SMS path.
export async function isolatedOtp(phone) {
  const url=process.env.TEST_DATABASE_MIGRATION_URL,secret=process.env.TEST_APP_TOKEN_SECRET;
  if(!url||!/^huahuo_test_(http|p03)_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))||!secret||!/^1[3-9]\d{9}$/.test(phone))throw new Error('ISOLATED_OTP_FIXTURE_REQUIRED');
  const pool=new pg.Pool({connectionString:url,max:1});
  const smsRequestId=randomUUID(),code=String(randomInt(1_000_000)).padStart(6,'0');
  const mac=value=>createHmac('sha256',secret).update(value).digest('hex');
  try{
    await pool.query("INSERT INTO otp_requests(id,provider,subject_hash,purpose,code_hash,delivery_status,provider_mode,request_hash,expires_at) VALUES($1,'phone',$2,'sign_in',$3,'sent','live',$4,now()+interval '5 minutes')",[smsRequestId,mac('+86'+phone),mac(smsRequestId+':'+code),mac(smsRequestId)]);
    return {smsRequestId,code};
  }finally{await pool.end();}
}
