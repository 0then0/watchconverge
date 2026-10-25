## Change

Describe the user-visible problem and resulting behavior. Link the related issue if applicable.

## Validation

List the commands actually run and their results. Explain unsupported cases or checks not run.

## Review checklist

- [ ] Changes stay within the local convergence-testing scope.
- [ ] Relevant regression tests and public documentation are updated.
- [ ] Snapshot requests do not repair the index being tested.
- [ ] Timeouts, unsupported cases and infrastructure failures cannot become PASS.
- [ ] Fixtures use tool-owned temporary trees; exports contain no secrets.
