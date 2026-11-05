import { createTheme } from "@mui/material/styles";

const serif = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
export const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#14263b", contrastText: "#f5efe0" },
    secondary: { main: "#b5432a", contrastText: "#fff8ec" },
    success: { main: "#2f6f5e" },
    warning: { main: "#a86f12" },
    error: { main: "#a3301f" },
    info: { main: "#2c6476" },
    background: { default: "#f5efe0", paper: "#fbf7ec" },
    text: { primary: "#14263b", secondary: "#5a6472" },
    divider: "rgba(20, 38, 59, 0.2)",
  },
  shape: { borderRadius: 2 },
  typography: {
    fontFamily: serif,
    fontSize: 15,
    h1: { fontStyle: "italic", fontWeight: 400 },
    h2: { fontSize: "1.65rem", fontWeight: 400 },
    h3: { fontSize: "1.2rem", fontWeight: 600 },
    h4: { fontSize: "1.05rem", fontWeight: 600 },
    button: { textTransform: "none", fontWeight: 600, letterSpacing: "0.01em" },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiCard: { defaultProps: { variant: "outlined" } },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: "#14263b", fontSize: "0.8rem", fontWeight: 400 },
        arrow: { color: "#14263b" },
      },
    },
    MuiChip: { styleOverrides: { root: { fontFamily: mono, fontSize: "0.72rem" } } },
  },
});
