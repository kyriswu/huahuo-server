#!/bin/sh
set -eu

case " ${RENEWED_DOMAINS:-} " in
    *" test-admin.chuda.cc "*)
        /usr/sbin/nginx -t
        /usr/bin/systemctl reload nginx
        ;;
esac
