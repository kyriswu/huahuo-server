云 PG CA 以只读文件挂载到 /app/certs；真实证书不提交。DATABASE_SSL_MODE=verify-full，DATABASE_SSL_CA_FILE=/app/certs/ca.pem。默认使用系统 CA。
