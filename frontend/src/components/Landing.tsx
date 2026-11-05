import { Alert, Button, Typography } from "@mui/material";
import { Rail, useCreateTrip } from "./Rail";
import { Slogan } from "./Slogan";

export function Landing() {
  const { pending, error, start } = useCreateTrip();
  return (
    <div className="shell shell--landing">
      <Rail />
      <main className="main">
        <Slogan />
        <Typography color="text.secondary" sx={{ maxWidth: 520, mb: 3 }}>
          Say where and when. Triplanner finds the places, checks their hours and tickets, and draws
          up a schedule you can follow on the map.
        </Typography>
        <div>
          <Button variant="contained" size="large" disabled={pending} onClick={() => void start()}>
            {pending ? "Creating..." : "Begin planning"}
          </Button>
        </div>
        {error && (
          <Alert severity="error" sx={{ mt: 2, maxWidth: 520 }}>
            {error}
          </Alert>
        )}
      </main>
    </div>
  );
}
