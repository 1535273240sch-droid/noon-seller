const {randomBytes} = require('node:crypto');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');

const environment = process.argv[2] || 'dev';
if (!['dev','staging','prod'].includes(environment)) throw new Error('Use dev, staging or prod');
const secret = () => randomBytes(32).toString('hex');
const values = {
  APP_ENV:environment,
  POSTGRES_PASSWORD:secret(), APP_DB_PASSWORD:secret(), MIGRATE_DB_PASSWORD:secret(),
  REDIS_PASSWORD:secret(), MINIO_ROOT_PASSWORD:secret(), STORAGE_APP_SECRET:secret(),
  JWT_SECRET:secret(), CREDENTIALS_MASTER_KEY:randomBytes(32).toString('base64'),
  BOOTSTRAP_EMAIL:'admin@example.invalid', BOOTSTRAP_PASSWORD:secret(),
  CORS_ORIGINS:'chrome-extension://gpbnbffcfojemjdadmldmepmaielcbdm'
};
const target=join(__dirname,'.env');
writeFileSync(target,Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('已创建 infra/docker/.env。首次登录使用其中的 BOOTSTRAP_EMAIL 和 BOOTSTRAP_PASSWORD。');
