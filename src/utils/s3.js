const S3 = require('aws-sdk/clients/s3');
const fs = require('fs');

const bucketName = process.env.AWS_BUCKET_NAME;
const region = process.env.AWS_BUCKET_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY;
const secretAccessKey = process.env.AWS_SECRET_KEY;

const s3 = new S3({
  region,
  accessKeyId,
  secretAccessKey,
});

/**
 * It will upload file to AWS S3
 * @param {file} file To uplaod
 * @returns uploaded file data like : location etc..
 */
const uploadFile = (file) => {
  const fileStream = fs.createReadStream(file.path);
  const uploadParams = {
    Bucket: bucketName,
    Body: fileStream,
    Key: file.filename,
  };
  return s3.upload(uploadParams).promise();
};

/**
 * It will get image from AWS S3
 * @param {string} fileKey To find image
 * @returns file
 */
const getFileStream = async (fileKey) => {
  const downloadParams = {
    Key: fileKey,
    Bucket: bucketName,
  };
  const file = await s3.getObject(downloadParams).createReadStream();
  return file;
};

/**
 * It will upload multiple file to AWS S3
 * @param {file} files To upload files
 * @returns uploaded files data like : location etc..
 */
const multipleImageUpload = async (files) => {
  const responses = await Promise.all(files.map((file) => uploadFile(file)));
  return responses;
};

module.exports = { uploadFile, getFileStream, multipleImageUpload };
