/*
  Warnings:

  - You are about to drop the column `password` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "users" DROP COLUMN "password";

-- CreateTable
CREATE TABLE "login" (
    "id" SERIAL NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "usersId" INTEGER,

    CONSTRAINT "login_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "login" ADD CONSTRAINT "login_usersId_fkey" FOREIGN KEY ("usersId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
