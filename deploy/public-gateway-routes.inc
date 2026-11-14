resolver 127.0.0.11 valid=5s;
client_max_body_size 8m;
access_log off;
set $api http://api:8083;
set $monitor http://monitor:8083;
proxy_http_version 1.1;
proxy_set_header Connection '';
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $qanda_client_address;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Qanda-Gateway-Key '';
location = /api/v1/health {
    proxy_pass $api/api/v1/health;
    proxy_pass_request_headers off;
    proxy_pass_request_body off;
    proxy_set_header Content-Length '';
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $qanda_client_address;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 15s;
}
location ~ ^/api/v1/admin/(monitoring/|statistics/(activity|rankings|online-users)$) {
    allow ${QANDA_GATEWAY_ALLOWED_CLIENT};
    deny all;
    if ($scheme = http) { return 503; }
    if ($qanda_gateway_authenticated = 0) { return 403; }
    proxy_pass $monitor$request_uri;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
location ~ ^/api/v1/admin(?:/|$) {
    allow ${QANDA_GATEWAY_ALLOWED_CLIENT};
    deny all;
    if ($scheme = http) { return 503; }
    if ($qanda_gateway_authenticated = 0) { return 403; }
    proxy_pass $api$request_uri;
    proxy_read_timeout 90s;
}
location /api/v1/ {
    if ($scheme = http) { return 503; }
    proxy_pass $api$request_uri;
    proxy_read_timeout 90s;
}
location / { return 404; }
