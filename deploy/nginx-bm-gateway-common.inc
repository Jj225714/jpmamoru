# No key is configured here. Each caller must provide their own Bearer credential.
access_log off;
error_log /var/log/nginx/aoweisi-bm-error.log crit;
if ($http_authorization !~* "^Bearer [A-Za-z0-9._-]+$") { return 401; }
if ($is_args != "") { return 400; }

client_max_body_size 128m;
client_body_timeout 60s;
limit_req zone=aoweisi_bm_requests burst=12 nodelay;
limit_req_status 429;
limit_conn aoweisi_bm_connections 12;
limit_conn_status 429;

proxy_http_version 1.1;
proxy_pass_request_headers off;
proxy_set_header Host bm.clawvp.com;
proxy_set_header Authorization $http_authorization;
proxy_set_header Content-Type $content_type;
proxy_set_header Accept $http_accept;
proxy_set_header Connection "";
proxy_set_header Origin "";
proxy_set_header Referer "";
proxy_set_header Cookie "";
proxy_set_header Accept-Encoding "";

proxy_ssl_server_name on;
proxy_ssl_name bm.clawvp.com;
proxy_ssl_verify on;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
proxy_ssl_verify_depth 4;
proxy_connect_timeout 20s;
proxy_read_timeout 610s;
proxy_send_timeout 60s;
send_timeout 610s;
proxy_next_upstream off;
proxy_buffering off;
gzip off;
proxy_request_buffering on;
proxy_cache off;
proxy_redirect off;
proxy_intercept_errors on;
error_page 301 302 303 307 308 = @aoweisi_bm_redirect_blocked;
proxy_hide_header Set-Cookie;
proxy_hide_header Access-Control-Allow-Origin;
add_header Cache-Control "no-store" always;
add_header X-Content-Type-Options "nosniff" always;
