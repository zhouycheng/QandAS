FROM nginx:1.28-alpine
ENV QANDA_API_UPSTREAM=http://api:8083 QANDA_MONITOR_UPSTREAM=http://monitor:8083
COPY deploy/web.conf /etc/nginx/templates/default.conf.template
COPY apps/admin/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
