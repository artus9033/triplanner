import { ThemeProvider } from "@mui/material";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { theme } from "../theme";

export const renderUi = (ui: ReactElement, route = "/") =>
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </ThemeProvider>,
  );
