SHELL := /bin/sh
NODE ?= node

.PHONY: help test demo verify clean

help:
	@echo "make test     运行 Node 单元测试"
	@echo "make demo     跑本地 RSS 采集与推送"
	@echo "make verify   断言 SQLite 状态机与投递状态"

test:
	$(NODE) --no-warnings --test

demo:
	$(NODE) --no-warnings src/cli.mjs demo

verify:
	sh scripts/verify.sh

clean:
	rm -rf /tmp/feedhub
