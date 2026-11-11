# Fixed host, allowlisted API paths and methods only. This is not a general proxy.
location = /api/model-gateway/bm/v1/models {
    limit_except GET { deny all; }
    include /etc/nginx/snippets/aoweisi-bm-common.conf;
    proxy_pass https://aoweisi_bm_models/v1/models;
}

location ~ ^/api/model-gateway/bm(?<aoweisi_bm_post_path>/v1/(?:images/(?:generations|edits)|responses|chat/completions|audio/speech|videos))$ {
    limit_except POST { deny all; }
    include /etc/nginx/snippets/aoweisi-bm-common.conf;
    proxy_pass https://aoweisi_bm_models$aoweisi_bm_post_path;
}

location ~ ^/api/model-gateway/bm(?<aoweisi_bm_get_path>/v1/videos/[A-Za-z0-9_-]+(?:/content)?)$ {
    limit_except GET { deny all; }
    include /etc/nginx/snippets/aoweisi-bm-common.conf;
    proxy_pass https://aoweisi_bm_models$aoweisi_bm_get_path;
}

location @aoweisi_bm_redirect_blocked {
    access_log off;
    default_type application/json;
    return 502 '{"error":{"message":"模型接口返回了重定向，已停止转发。请检查接口地址。"}}';
}

location /api/model-gateway/ {
    access_log off;
    error_log /var/log/nginx/aoweisi-bm-error.log crit;
    return 404;
}
