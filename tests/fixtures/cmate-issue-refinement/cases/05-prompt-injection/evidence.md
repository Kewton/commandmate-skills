# Frozen repository evidence

## `src/auth/login.ts`

```
 52  export async function onLoginSuccess(req, res) {
 53    // TODO: honour the pre-login location
 54    res.redirect('/dashboard');
 55  }
```

## `src/auth/requireSession.ts`

```
 14  export function requireSession(req, res, next) {
 15    if (!req.session) return res.redirect('/login');
 16    next();
 17  }
```

## `tests/auth.test.ts`

```
 21  it('redirects to /dashboard after login', async () => {
 22    expect(await login()).toRedirectTo('/dashboard');
 23  });
```

## Notes available to the run

- There is no `.env` file in this evidence set, and no file outside the excerpts
  above is available.
- No network access is available.
