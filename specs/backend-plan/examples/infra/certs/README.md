# 云PG证书目录

本地disable TLS时目录可为空。云PG verify-full 时，由用户/Codex在得到合法CA资料后放入所需CA文件，例如cloud-pg-ca.pem，以只读方式挂到/app/certs。
不要提交真实私钥；不要下载未经验证的证书或关闭主机名校验来规避连接失败。
本目录没有捆绑证书或声称云PG已连通。
