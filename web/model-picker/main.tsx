import { createRoot } from "react-dom/client";
import { ModelPicker } from "./ModelPicker.js";
import { createAccountsApi } from "./accounts.js";
const root = document.getElementById("root");
if (root) createRoot(root).render(<ModelPicker accountsApi={createAccountsApi()} />);
