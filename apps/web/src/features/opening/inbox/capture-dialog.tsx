"use client";

import { UploadDropzone } from "./upload-dropzone";

type CourseRole = "core" | "optional" | "reference";

type Props = {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  /** Optional course context; association is performed by the parent after a successful upload. */
  courseId?: string | null;
  courseRole?: CourseRole;
};

export function CaptureDialog({ disabled, onFiles, courseId: _courseId, courseRole: _courseRole }: Props) {
  return <UploadDropzone capture="environment" disabled={disabled} onFiles={onFiles} />;
}
