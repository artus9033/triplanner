import { Alert, Button, Dialog, DialogContent, DialogTitle, TextField } from "@mui/material";
import { useState, type FormEvent } from "react";
import { useAuthStore } from "../authStore";
import { useAction } from "../lib/useAction";

/** Sits above the app, so whatever was on screen resumes once parked requests are re-sent. */
export function AuthGate() {
  const required = useAuthStore((s) => s.required);
  const submit = useAuthStore((s) => s.submit);
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAction();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (await run(() => submit(password))) setPassword("");
  };

  return (
    <Dialog open={required} aria-labelledby="auth-title">
      <DialogTitle id="auth-title">This app needs a password</DialogTitle>
      <DialogContent>
        <form onSubmit={(event) => void onSubmit(event)} aria-label="Access password form">
          <TextField
            label="Access password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            fullWidth
            margin="dense"
            autoComplete="current-password"
          />
          {error && (
            <Alert severity="error" sx={{ my: 1 }}>
              {error}
            </Alert>
          )}
          <Button type="submit" variant="contained" disabled={pending || !password} sx={{ mt: 1 }}>
            {pending ? "Checking..." : "Unlock"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
