# Frozen repository evidence

The checkout is readable, but empty of anything relevant:

## `README.md`

```
  1  # widget-service
```

## Notes available to the run

- The failure is in retrieving the Issue, not in reading the checkout. An Agent
  that reports `evidence_unavailable` has diagnosed the wrong thing.
- Retrying the fetch is pointless; the Issue number does not exist.
