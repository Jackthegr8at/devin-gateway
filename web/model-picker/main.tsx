import { createRoot } from "react-dom/client";
import { ModelPicker } from "./ModelPicker.js";
const root = document.getElementById("root");
if (root) createRoot(root).render(<ModelPicker />);
