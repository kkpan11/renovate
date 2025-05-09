The `helmsman` manager is currently limited and does not support the full feature set of [Helmsman](https://github.com/Praqma/helmsman), read about the limitations below.

### Non-configured managerFilePatterns

By default the `helmsman` manager has an empty array for its `managerFilePatterns` configuration option, because there is no convention for file naming in practice.
This means that `helmsman` won't search for any files, and you won't get any updates from the manager.

To enable the `helmsman` manager, provide a valid `managerFilePatterns` yourself, for example:

```json
{
  "helmsman": {
    "managerFilePatterns": ["/(^|/)desired_state\\.yaml$/"]
  }
}
```

### File format

Currently, state files must be in the `.yaml` format.
The `.toml` format is not supported.
