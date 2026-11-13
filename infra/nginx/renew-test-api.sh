#!/bin/sh
set -eu

# Certbot calls deploy hooks only after successfully renewing a certificate.
case " ${RENEWED_DOMAINS:-} " in
    *" test-api.chuda.cc "*)
        /usr/sbin/nginx -t
        /usr/bin/systemctl reload nginx
        ;;
esac
