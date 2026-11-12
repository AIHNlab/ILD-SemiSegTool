import React, { useCallback, useState } from 'react';
import { ReactElement } from 'react';
import Dropzone from 'react-dropzone';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import DicomFileUploader from '../../utils/DicomFileUploader';
import DicomUploadProgress from './DicomUploadProgress';
import { Button, ButtonEnums } from '@ohif/ui';
import './DicomUpload.css';

type DicomUploadProps = {
  dataSource;
  onComplete: () => void;
  onStarted: () => void;
};

// Files a DICOM folder often contains that are certainly not DICOM images
// (macOS/Windows housekeeping files, DICOMDIR indexes, reports, previews).
// Dropped before upload, so they don't show up as failed uploads.
const NOT_DICOM_NAMES = new Set(['dicomdir', 'thumbs.db', 'desktop.ini', 'icon\r']);
const NOT_DICOM_EXTENSIONS =
  /\.(txt|xml|html?|pdf|jpe?g|png|gif|bmp|tiff?|json|csv|ini|inf|exe|bat|sh|zip|7z|rar|doc|docx|xls|xlsx|md|log|db|lnk|url|plist)$/i;

function isClearlyNotDicom(file: File): boolean {
  const name = (file.name || '').toLowerCase();
  return name.startsWith('.') || NOT_DICOM_NAMES.has(name) || NOT_DICOM_EXTENSIONS.test(name);
}

function DicomUpload({ dataSource, onComplete, onStarted }: DicomUploadProps): ReactElement {
  const baseClassNames = 'min-h-[480px] flex flex-col bg-black select-none';
  const [dicomFileUploaderArr, setDicomFileUploaderArr] = useState([]);

  const onDrop = useCallback(async acceptedFiles => {
    onStarted();
    setDicomFileUploaderArr(
      acceptedFiles
        .filter(file => !isClearlyNotDicom(file))
        .map(file => new DicomFileUploader(file, dataSource))
    );
  }, []);

  const getDropZoneComponent = (): ReactElement => {
    return (
      <Dropzone
        onDrop={acceptedFiles => {
          onDrop(acceptedFiles);
        }}
        noClick
      >
        {({ getRootProps }) => (
          <div
            {...getRootProps()}
            className="dicom-upload-drop-area-border-dash m-5 flex h-full flex-col items-center justify-center"
          >
            <div className="flex gap-3">
              <Dropzone
                onDrop={onDrop}
                noDrag
              >
                {({ getRootProps, getInputProps }) => (
                  <div {...getRootProps()}>
                    <Button
                      disabled={false}
                      onClick={() => {}}
                    >
                      {'Add files'}
                      <input {...getInputProps()} />
                    </Button>
                  </div>
                )}
              </Dropzone>
              <Dropzone
                onDrop={onDrop}
                noDrag
              >
                {({ getRootProps, getInputProps }) => (
                  <div {...getRootProps()}>
                    <Button
                      type={ButtonEnums.type.secondary}
                      disabled={false}
                      onClick={() => {}}
                    >
                      {'Add folder'}
                      <input
                        {...getInputProps()}
                        webkitdirectory="true"
                        mozdirectory="true"
                      />
                    </Button>
                  </div>
                )}
              </Dropzone>
            </div>
            <div className="pt-5">or drag images or folders here</div>
            <div className="text-aqua-pale pt-3 text-lg">(DICOM files supported)</div>
          </div>
        )}
      </Dropzone>
    );
  };

  return (
    <>
      {dicomFileUploaderArr.length ? (
        <div className={classNames('h-[calc(100vh-300px)]', baseClassNames)}>
          <DicomUploadProgress
            dicomFileUploaderArr={Array.from(dicomFileUploaderArr)}
            onComplete={onComplete}
          />
        </div>
      ) : (
        <div className={classNames('h-[480px]', baseClassNames)}>{getDropZoneComponent()}</div>
      )}
    </>
  );
}

DicomUpload.propTypes = {
  dataSource: PropTypes.object.isRequired,
  onComplete: PropTypes.func.isRequired,
  onStarted: PropTypes.func.isRequired,
};

export default DicomUpload;
