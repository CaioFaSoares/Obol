import { Elysia } from "elysia";

const port = process.env.PORT || 8080;
const app = new Elysia().get("/", () => "Hello Elysia").listen(port);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
