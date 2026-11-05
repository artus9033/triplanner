import { CssBaseline, ThemeProvider } from "@mui/material";
import { useEffect } from "react";
import { Route, Routes } from "react-router";
import { AuthGate } from "./components/AuthGate";
import { Landing } from "./components/Landing";
import { TripWorkspace } from "./components/TripWorkspace";
import { useTripStore } from "./store";
import { theme } from "./theme";

export function App() {
  const loadTrips = useTripStore((s) => s.loadTrips);
  useEffect(() => {
    void loadTrips();
  }, [loadTrips]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/trips/:id" element={<TripWorkspace />} />
        <Route path="*" element={<Landing />} />
      </Routes>
      <AuthGate />
    </ThemeProvider>
  );
}
