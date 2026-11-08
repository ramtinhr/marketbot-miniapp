#!/usr/bin/env bash
project=marketbot-miniapp
legacy_container=marketbot-miniapp-server
services=('server' 'web')
image_vars=('MINIAPP_SERVER_IMAGE' 'MINIAPP_WEB_IMAGE')
dockerfiles=('server/Dockerfile' 'web/Dockerfile')
image_suffixes=('/server' '/web')
sidecars=()
