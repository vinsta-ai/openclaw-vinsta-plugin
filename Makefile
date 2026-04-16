.PHONY: install verify

install:
	openclaw plugins install .

verify:
	openclaw vinsta status
