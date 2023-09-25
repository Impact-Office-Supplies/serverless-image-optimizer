'use strict';

const async = require('async');
const AWS = require('aws-sdk');
const util = require('util');
const gm = require('gm').subClass({ imageMagick: true, binPath: "/opt/bin" });
const fs = require('fs');
const imagemin = require('imagemin');
const imageminJpegRecompress = require('imagemin-jpeg-recompress');
const imageminJpegtran = require('imagemin-jpegtran');
const imageminPngquant = require('imagemin-pngquant');
const json2csv = require('json2csv').parse;
const csv = require('csv-parser');
const s3 = new AWS.S3({
  maxRetries: 3,
  httpOptions: {timeout: 60000, connectTimeout: 20000},
  timeout: 60000 // Matching Lambda function timeout
});

/*
 * I am encoding the size for the images in the folder name.
 * This regex helps identify the size patterns:
 *   700x700
 *   700x700_1800x1800
 *   700x700-1800x1800
 *   500x500_700x700-1800x1800
 */
const sizeRegex = /(\d+x\d+(-|_)?)+/;

const IMG_EXTENSION = 'PNG';
const SRC_FOLDER = 'originals/';
const DEST_FOLDER = 'processed/';
const SRC_BUCKET = process.env.BUCKET;
const DEST_BUCKET = process.env.BUCKET;
const QUALITY = [0.6, 0.8]; // Quality for PNGs
const IMAGE_GRAVITY = 'Center'; // Image position in background
const IMAGE_BACKGROUND_COLOR = '#FFFFFF'; // Background to fill any gaps in full size
const BORDER_SIZE = 30; // Can set to 0 if no border.
const WRITE_LOG_TO_S3 = false;

module.exports.handler = async event => {
  log('Reading options from event:\n', util.inspect(event, { depth: 5 }));
  
  const { s3: s3Obj } = event.Records[0];
  const srcBucket = s3Obj.bucket.name;
  const srcKey = decodeURIComponent(s3Obj.object.key.replace(/\+/g, ' '));
  const absoluteImagePath = `${srcBucket}/${srcKey}`;
  let processedImages = [];
  
  // Get the sizes encoded in the path of the image
  const sizeMatch = srcKey.match(sizeRegex);
  if (!sizeMatch) {
    throw Error(`Size not specified for file: ${absoluteImagePath}`);
  }

  log(`Getting image from S3: ${absoluteImagePath}`);

  const response = await s3
    .getObject({ Bucket: srcBucket, Key: srcKey })
    .promise();

  log('Get image from S3 done');

  const sizes = sizeMatch[0].split(/-|_/);

  for (const size of sizes) {
    log(`Resizing image to size: ${size}`);

    const [width, height] = getWidthAndHeightFromSize(size);

    log(`Dimensions on image are ${width} x ${height}`);

    const resizedImage = await resizeImage({
      content: response.Body,
      IMG_EXTENSION,
      width,
      height,
    });

    log(`Compressing image. Quality: ${QUALITY[0]} to ${QUALITY[1]}`);

    let compressedImage = resizedImage;

    try {
      compressedImage = await imagemin.buffer(resizedImage, {
        plugins: [
          imageminJpegRecompress(),
          imageminJpegtran(),
          imageminPngquant({
            quality: QUALITY
          })
        ],
      });

      log('Image compression complete');
    } catch (error) {
      log('[Handled Error] Could not compress image, using resized image only. Error details below:');
      log(error);
    }

    const dstKey = srcKey.split(SRC_FOLDER)[1].replace(sizeRegex, size);
    
    log(`Uploading processed image to: ${dstKey}`);

    // Upload to S3, max age = 1 week, 2 mins to serve old content while revalidating, 1d to serve stale content if there's an error
    try {
      await s3
        .putObject({
          Bucket: DEST_BUCKET,
          Key: `${DEST_FOLDER}${dstKey}`,
          Body: compressedImage,
          ContentType: response.ContentType,
          CacheControl: "max-age=604800, stale-while-revalidate=120, stale-if-error=86400"
        })
      .promise();

      log(`Uploaded processed image complete to: ${dstKey}`);

      processedImages.push(`${DEST_FOLDER}${dstKey}`);
    } catch (err) {
      log('[Non-handled Error Below] Resized image failed upload.');
      log(err);
    }
  }

  log(`Successfully processed ${srcBucket}/${srcKey}`);

  if (WRITE_LOG_TO_S3 === true) {
    await writeLogToS3(processedImages);
  }
};

function log(...args) {
  console.log('================================================================================');
  console.log(...args);
  console.log('================================================================================');
}

/**
 * Get enable to use memory size in ImageMagick
 * Typically we determine to us 90% of max memory size
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/lambda-environment-variables.html
 */
const getEnableMemory = () => {
  const mem = parseInt(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE, 10);
  return Math.floor(mem * 90 / 100);
};

function getWidthAndHeightFromSize(size) {
  return size.split('x');
}

function resizeImage({ width, height, imgExtension, content }) {
  return new Promise((resolve, reject) => {
    gm(content)
      .limit("memory", `${getEnableMemory()}MB`)
      .autoOrient()
      .noProfile()
      .resize(width - BORDER_SIZE, height - BORDER_SIZE)
      .gravity(IMAGE_GRAVITY)
      .background(IMAGE_BACKGROUND_COLOR)
      .extent(width, height)
      .toBuffer('jpeg', function(err, buffer) {
        if (err) reject(err);
        else resolve(buffer);
      });
  });
}

function writeLogToS3(processedImagesArray) {
  return new Promise((resolve, reject) => {
    (async () => {

      // Initial variables
      const today = new Date();
      const year = today.getFullYear();
      const month = `${today.getMonth() + 1}`.padStart(2, "0");
      const day = `${today.getDate()}`.padStart(2, "0");
      const processedImagesString = processedImagesArray.join(', ');

      let csvLog = [];
      let destFilePath = null;
      let dailyCsvName = null;
      let s3FilePath = null;
      let csvFile = null;
      let writeArray = [];

      log(`Processed Images to be logged: ${processedImagesString}`);

      // Build CSV name
      dailyCsvName = `${year}_${month}_${day}_processed_images.csv`;
      destFilePath = '/tmp/' + dailyCsvName;
      s3FilePath = 'csv_log/' + dailyCsvName;

      log(`Looking for daily CSV: ${dailyCsvName}`);

      // Check if it exists in S3 already
      // If exists, DL it and push it into /tmp/ file
      
      const currentCsvExists = await s3
        .headObject({ Bucket: SRC_BUCKET, Key: s3FilePath })
        .promise()
        .then(
          () => true,
          err => {
            if (err.code === 'NotFound') {
              return false;
            }
            throw err;
          }
        );

      log(`Does current CSV Log file exist? ${currentCsvExists}`);

      if (currentCsvExists) {
        const currentCsv = await new Promise((resolve, reject) => {
          let currentCsv = [];

          try {
            let stream = s3
              .getObject({ Bucket: SRC_BUCKET, Key: s3FilePath }, function (err, data) {
                if (err) {
                  log(err);

                  throw err;
                }
              })
              .createReadStream();

            stream
              .pipe(csv())
              .on('data', (row) => {
                // log(row);

                currentCsv.push(row);
              })
              .on('error', () => {
                stream.end();
              })
              .on('end', () => {
                log('CSV file successfully read');

                resolve(currentCsv);
              });
          } catch (err) {
            log('Error reading stream for CSV');
            log(err);
            
            if (stream) stream.end();
          }
        });

        writeArray = writeArray.concat(currentCsv);

        log('Found CSV Log on server');
      } else {
        log('No CSV Log found on server, creating new one.');
      }
      
      // Loop over each of the image names and push into /tmp/ csv
      
      const fields = ['name', 'date'];

      for (let i = 0; i < processedImagesArray.length; i++) {
        writeArray.push({
          name: processedImagesArray[i],
          date: today.toISOString()
        });
      }

      const csvToUpload = json2csv(writeArray, { fields });

      log(csvToUpload);

      // Write to file
      await fs
        .promises
        .writeFile(destFilePath, csvToUpload, function (err) {
           if (err) {
             log(err);

             throw error;
           }

           log('Uploaded to tmp successfully');
        });

      // Upload file back to S3
      await fs
        .readFile(destFilePath, "utf8", function (err, data) {
          log(`Read dest file from tmp`);

          if (err) {
            log(`Error reading file ${err}`);

            throw err; 
          }

          const base64data = Buffer.from(data, 'binary');

          s3
            .putObject({
              Bucket: SRC_BUCKET,
              Key: s3FilePath,
              Body: base64data,
              ContentType: 'application/octet-stream',
              ContentDisposition: 'attachment',
              CacheControl: 'public, max-age=86400'
            })
            .promise();

          log('Upload finished to S3');
        });
    })();
  });
}
