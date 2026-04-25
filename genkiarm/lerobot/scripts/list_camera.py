import cv2

def capture_images_with_ids(max_id=10, save_path="camera_id_images/"):
    """
    使用可用摄像头拍照并在图片上标记摄像头 ID。
    :param max_id: 假设的最大摄像头 ID 范围（默认 0 到 max_id-1）。
    :param save_path: 保存图片的路径（默认 "camera_id_images/"）。
    """
    import os
    if not os.path.exists(save_path):
        os.makedirs(save_path)

    for cam_id in range(max_id):
        cap = cv2.VideoCapture(cam_id)
        if cap.isOpened():
            ret, frame = cap.read()
            if ret:
                # 在图片上添加摄像头 ID
                text = f"Camera ID: {cam_id}"
                font = cv2.FONT_HERSHEY_SIMPLEX
                cv2.putText(frame, text, (10, 50), font, 1, (0, 255, 0), 2)

                # 保存图片
                img_path = os.path.join(save_path, f"camera_{cam_id}.jpg")
                cv2.imwrite(img_path, frame)
                print(f"已保存摄像头 {cam_id} 的图片：{img_path}")

            cap.release()
        else:
            print(f"摄像头 {cam_id} 无法打开。")

    print("拍照完成！")

# 调用函数
capture_images_with_ids(max_id=10)
