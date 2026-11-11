# Included only inside the HTTPS server. Never place snapshots in the web root.
location ~ ^/private-data/snapshot-[A-Za-z0-9-]+\.zip$ {
    root /var/lib/aoweisi-sync;
    auth_basic "Aoweisi private workspace";
    auth_basic_user_file /etc/nginx/aoweisi-workspace.htpasswd;
    client_max_body_size 512m;
    client_body_timeout 300s;
    dav_methods PUT;
    create_full_put_path off;
    # Keep a successfully uploaded snapshot immutable, including retries.
    set $existing_snapshot_method "";
    if (-f $request_filename) { set $existing_snapshot_method $request_method; }
    if ($existing_snapshot_method = PUT) { return 409; }
    dav_access user:rw;
    limit_except GET PUT OPTIONS { deny all; }
    add_header Cache-Control "no-store" always;
    add_header Access-Control-Allow-Origin "http://localhost:3001" always;
    add_header Access-Control-Allow-Methods "GET, HEAD, PUT, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    add_header Access-Control-Expose-Headers "Content-Length, ETag" always;
    add_header Vary "Origin" always;
    if ($request_method = OPTIONS) { return 204; }
}
location /private-data/ { return 404; }
