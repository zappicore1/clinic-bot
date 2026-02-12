import express from "express";
import dotenv from "dotenv";
import { handleWebhookVerification, handleIncomingMessage } from "./whatsapp.js";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

app.get("/webhook", handleWebhookVerification);
app.post("/webhook", async (req, res) => {
  try {
    await handleIncomingMessage(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
