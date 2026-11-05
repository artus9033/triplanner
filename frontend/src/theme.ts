import { createTheme } from "@mui/material/styles";

/** Dark purple is the only accent. Everything else stays neutral, and status colors are muted. */
const PRIMARY = "#3b1d6e";
const TEXT = "#1c1b1f";

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: PRIMARY, contrastText: "#ffffff" },
    secondary: { main: "#5f5b66", contrastText: "#ffffff" },
    success: { main: "#3f6b55" },
    warning: { main: "#8a5a00" },
    error: { main: "#b3261e" },
    info: { main: "#5f5b66" },
    background: { default: "#ffffff", paper: "#ffffff" },
    text: { primary: TEXT, secondary: "#5f5b66" },
    divider: "rgba(28, 27, 31, 0.12)",
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: 'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
    h1: { fontWeight: 400 },
    h2: { fontSize: "1.5rem", fontWeight: 400 },
    h3: { fontSize: "1.125rem", fontWeight: 500 },
    h4: { fontSize: "1rem", fontWeight: 500 },
    button: { textTransform: "none", fontWeight: 500, letterSpacing: "0.01em" },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { defaultProps: { variant: "outlined" } },
    MuiChip: { defaultProps: { variant: "outlined" } },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: TEXT, fontSize: "0.75rem", fontWeight: 400 },
        arrow: { color: TEXT },
      },
    },
  },
});
