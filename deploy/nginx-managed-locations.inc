# Access-code/shared-key endpoints are retired. Do not make them anonymous.
location = /api/managed { return 410; }
location ^~ /api/managed/ { return 410; }

# Provider credentials plus a dedicated task session, verified by the local relay.
# Never forward the main vault cookie or unrelated browser cookies.
location ^~ /api/providers/ {
    set $provider_task_cookie "";
    # Reject ambiguous duplicate cookies rather than silently selecting an account.
    if ($http_cookie ~ "(?:^|;\s*)__Secure-provider_tasks=[^;]*(?:;[^;]*)*;\s*__Secure-provider_tasks=") {
        return 401;
    }
    if ($http_cookie ~ "(?:^|;\s*)(__Secure-provider_tasks=[A-Za-z0-9_-]{43})(?:;|$)") {
        set $provider_task_cookie $1;
    }
    client_max_body_size 48m;
    access_log off;
    error_log /var/log/nginx/aoweisi-provider-error.log crit;
    limit_req zone=aoweisi_bm_requests burst=12 nodelay;
    limit_conn aoweisi_bm_connections 8;
    proxy_pass http://127.0.0.1:3181;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header Sec-Fetch-Site $http_sec_fetch_site;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Azure-Resource $http_x_azure_resource;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Cookie $provider_task_cookie;
    proxy_set_header Connection "";
    proxy_next_upstream off;
    proxy_connect_timeout 10s;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
}
