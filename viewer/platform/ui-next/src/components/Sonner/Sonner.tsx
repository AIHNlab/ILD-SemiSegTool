import React from 'react';
import { Toaster as Sonner } from 'sonner';
import { Icons } from '../Icons';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      loadingIcon={<Icons.LoadingSpinner />}
      icons={{
        warning: <Icons.StatusWarning />,
        info: <Icons.Info className="text-secondary-foreground" />,
        success: <Icons.StatusSuccess />,
        error: <Icons.StatusError />,
      }}
      theme="dark"
      richColors="true"
      // Widen the toaster itself (sonner's --width, default 356px). Setting only
      // the toast's width made it overflow the right-anchored container, so the
      // end of longer messages was cut off at the screen edge.
      style={{ '--width': '430px' } as React.CSSProperties}
      {...props}
    />
  );
};

export { Toaster };
