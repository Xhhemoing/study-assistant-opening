"use client";
import type { Sql } from "postgres";
import { type Row } from "./types";
export type X = Sql | Row;
