#!/bin/sh

IFS= read -r query
case "$query" in
  parse-failure)
    printf '\tno structure\n'
    printf 'OPSIN could not parse the supplied name\n' >&2
    ;;
  non-zero)
    printf 'simulated JVM failure\n' >&2
    exit 7
    ;;
  ambiguous)
    printf 'CCCCC\t%s\n' "$query"
    printf 'APPEARS_AMBIGUOUS: Connection of meth to but\n' >&2
    ;;
  timeout)
    trap '' TERM
    while :; do sleep 0.001; done
    ;;
  *)
    printf 'CCO\t%s\n' "$query"
    ;;
esac
