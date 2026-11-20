#!/bin/sh
# 预览/生产镜像重建（112 上执行）：去掉 # syntax 行（docker.io 被墙）+ 重建
set -e
cd /srv/dsh-preview
grep -v '^# syntax=docker' src-new/Dockerfile.app > src-new/Dockerfile.app.tmp
mv src-new/Dockerfile.app.tmp src-new/Dockerfile.app
head -2 src-new/Dockerfile.app
docker build -q -f src-new/Dockerfile.app --build-context models=models -t dsh-embed:v2-preview src-new 2>&1 | tail -2
